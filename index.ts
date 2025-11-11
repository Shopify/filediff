import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import * as util from 'node:util';

import {getInput, setFailed, info} from '@actions/core';
import * as github from '@actions/github';
import {exec} from '@actions/exec';
import {globby} from 'globby';
import prettyBytes from 'pretty-bytes';

const gzip = util.promisify(zlib.gzip);
const brotliCompress = util.promisify(zlib.brotliCompress);

type BranchStats = {
  totalSize: number;
  totalGzip: number;
  totalBrotli: number;
  files: {
    [key: string]: {
      size: number;
      gzip: number;
      brotli: number;
    };
  };
};

const commentHash = '<!-- @alex-page was here -->';

const getFileStats = async (
  file: string,
  branch: string,
  branchStats: BranchStats,
) => {
  const stats = await fs.promises.stat(file);
  const fileContents = await fs.promises.readFile(file);

  const gzipFile = await gzip(fileContents);
  const gzipSize = Buffer.byteLength(gzipFile);
  const brotliFile = await brotliCompress(fileContents);
  const brotliSize = Buffer.byteLength(brotliFile);

  // Remove the GitHub file path from the repo file path
  const filePath = file.split(`${branch}/`).slice(1)[0]!;

  branchStats.totalSize += stats.size;
  branchStats.totalGzip += gzipSize;
  branchStats.totalBrotli += brotliSize;
  branchStats.files[filePath] = {
    size: stats.size,
    gzip: gzipSize,
    brotli: brotliSize,
  };
};

const getBranchStats = async (
  branch: string,
  dirGlob: string,
  script?: string,
) => {
  info(`[${branch}] copy repo and git checkout `);
  const tempDir = '.filediff';
  const cwd = `../${tempDir}/${branch}`;
  await fs.promises.cp('.', cwd, {recursive: true});
  await exec('git', ['fetch', 'origin', branch], {cwd});
  await exec('git', ['checkout', branch], {cwd});

  if (script) {
    info(`[${branch}] Running ${script}`);
    const commands = script.split('&&').map((cmd) => cmd.trim());
    for (const cmd of commands) {
      const [cmdName, ...cmdArgs] = cmd.split(/\s+/);
      await exec(cmdName!, cmdArgs, {cwd});
    }
  }

  const files = await globby(dirGlob.split(','), {cwd, absolute: true});

  info(`[${branch}] Getting file stats for ${files.length} files`);

  // Log first few file paths for debugging
  if (files.length > 0) {
    const sampleFiles = files
      .slice(0, 3)
      .map((f) => f.split(`${branch}/`).slice(1)[0]);
    info(
      `[${branch}] Sample files: ${sampleFiles.join(', ')}${files.length > 3 ? '...' : ''}`,
    );
  }

  const branchStats: BranchStats = {
    totalSize: 0,
    totalBrotli: 0,
    totalGzip: 0,
    files: {},
  };

  await Promise.all(
    files.map((file) => getFileStats(file, branch, branchStats)),
  );

  info(`[${branch}] Completed file stats`);

  return branchStats;
};

const getCommonStringStart = (strings: string[]): string => {
  if (strings.length < 2) return '';

  const sortedStrings = strings.slice().sort();

  // The first and last strings are the most different
  const first = sortedStrings[0]!;
  const last = sortedStrings[sortedStrings.length - 1]!;

  for (let i = 0; i < first.length; i++) {
    if (first[i] !== last[i]) return first.slice(0, i);
  }

  return first;
};

export const getStatComment = (
  targetStats: BranchStats,
  prStats: BranchStats,
  fileDetailsOpen: Boolean,
): string => {
  const fileTotals = {
    changed: 0,
    removed: 0,
    added: 0,
  };

  const getDiff = (a: number, b: number) => prettyBytes(a - b, {signed: true});
  const totalDiff = {
    size: getDiff(prStats.totalSize, targetStats.totalSize),
    gzip: getDiff(prStats.totalGzip, targetStats.totalGzip),
    brotli: getDiff(prStats.totalBrotli, targetStats.totalBrotli),
  };

  const allFilePaths = new Set([
    ...Object.keys(prStats.files),
    ...Object.keys(targetStats.files),
  ]);

  const commonStart = getCommonStringStart([...allFilePaths]);
  const commonFilePath = commonStart.slice(0, commonStart.lastIndexOf('/') + 1);

  let fileColumns: string[] = [];
  Object.entries(prStats.files).forEach(([filePath, {size, brotli, gzip}]) => {
    const targetFile = targetStats.files[filePath];

    if (!targetFile) {
      // File in PR is not in target branch (added)
      fileTotals.added = fileTotals.added + 1;
      fileColumns.push(
        `| <sub>${filePath.slice(commonFilePath.length)}</sub> | <sub>${prettyBytes(size)} \`${prettyBytes(size, {signed: true})}\`</sub> | <sub>${prettyBytes(gzip)} \`${prettyBytes(gzip, {signed: true})}\`</sub> | <sub>${prettyBytes(brotli)} \`${prettyBytes(brotli, {signed: true})}\`</sub> |`,
      );
    } else if (size !== targetFile.size) {
      // File in PR is in target branch
      fileTotals.changed = fileTotals.changed + 1;
      fileColumns.push(
        `| <sub>${filePath.slice(commonFilePath.length)}</sub> | <sub>${prettyBytes(size)} \`${getDiff(size, targetFile.size)}\`</sub> | <sub>${prettyBytes(gzip)} \`${getDiff(gzip, targetFile.gzip)}\`</sub> | <sub>${prettyBytes(brotli)} \`${getDiff(brotli, targetFile.brotli)}\`</sub> |`,
      );
    }
  });

  Object.entries(targetStats.files).forEach(
    ([filePath, {size, brotli, gzip}]) => {
      const prFile = prStats.files[filePath];
      if (prFile === undefined) {
        fileTotals.removed = fileTotals.removed + 1;
        fileColumns.push(
          `| <sub>~${filePath.slice(commonFilePath.length)}~</sub> | <sub>0 B \`${prettyBytes(-1 * size, {signed: true})}\`</sub> | <sub>0 B \`${prettyBytes(-1 * gzip, {signed: true})}\`</sub> | <sub>0 B \`${prettyBytes(-1 * brotli, {signed: true})}\`</sub> |`,
        );
      }
    },
  );

  const pluralize = (count: number, single: string, plural: string) =>
    count === 1 ? single : plural;

  const detailsSummaryText = [];
  if (fileTotals.changed !== 0)
    detailsSummaryText.push(
      `${fileTotals.changed} ${pluralize(
        fileTotals.changed,
        'file changed',
        'files changed',
      )}`,
    );
  if (fileTotals.added !== 0)
    detailsSummaryText.push(
      `${fileTotals.added} ${pluralize(fileTotals.added, 'file added', 'files added')}`,
    );
  if (fileTotals.removed !== 0)
    detailsSummaryText.push(
      `${fileTotals.removed} ${pluralize(
        fileTotals.removed,
        'file removed',
        'files removed',
      )}`,
    );

  return `${commentHash}\n<sub>**[[filediff]](https://github.com/shopify/filediff)** The total bytes ${totalDiff.size.startsWith('+') ? 'added' : 'removed'} are:</sub>
  | uncompressed | gzip | brotli |
  |:--- |:--- |:--- |
  | <sub>${prettyBytes(prStats.totalSize)} \`${totalDiff.size}\`</sub> | <sub>${prettyBytes(prStats.totalGzip)} \`${totalDiff.gzip}\`</sub> | <sub>${prettyBytes(prStats.totalBrotli)} \`${totalDiff.brotli}\`</sub> |


  <details${fileDetailsOpen ? ' open' : ''}>
    <summary><sub>${detailsSummaryText.join(', ')}</sub></summary>

${commonFilePath ? `<sub>All changed files are in ${commonFilePath}</sub>` : ''}

| Filename | size  | gzip | brotli |
|:--- | ---:| ---:| ---:|
${fileColumns.join('\n')}
  </details>
  `;
};

const run = async () => {
  try {
    info('Creating filediff comment');
    if (!process.env.GITHUB_TOKEN) {
      throw new Error(`Missing required environment variables: GITHUB_TOKEN`);
    }

    const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
    const {payload} = github.context;
    if (!payload.repository || !payload.pull_request) return;
    const prBranch = payload.pull_request.head.ref;
    const prNumber = payload.pull_request.number;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;

    const targetBranch = getInput('target_branch', {required: true});
    const dirGlob = getInput('dir_glob', {required: true});
    const script = getInput('pre_diff_script');
    const fileDetailsOpen = getInput('file_details_open');
    const replaceComment = getInput('replace_comment');

    const [targetStats, prStats] = await Promise.all([
      getBranchStats(targetBranch, dirGlob, script),
      getBranchStats(prBranch, dirGlob, script),
    ]);

    info('='.repeat(50));
    info('Comparing branches:');
    info(`  Target: ${targetBranch}`);
    info(`    - Total size: ${prettyBytes(targetStats.totalSize)}`);
    info(`    - Files: ${Object.keys(targetStats.files).length}`);
    info(`  PR Branch: ${prBranch}`);
    info(`    - Total size: ${prettyBytes(prStats.totalSize)}`);
    info(`    - Files: ${Object.keys(prStats.files).length}`);
    info('='.repeat(50));

    // Check for file differences and log them
    const allFilePaths = new Set([
      ...Object.keys(prStats.files),
      ...Object.keys(targetStats.files),
    ]);

    const fileChanges = {
      added: [] as string[],
      removed: [] as string[],
      modified: [] as string[],
    };

    allFilePaths.forEach((filePath) => {
      const prFile = prStats.files[filePath];
      const targetFile = targetStats.files[filePath];

      if (!targetFile) {
        fileChanges.added.push(filePath);
      } else if (!prFile) {
        fileChanges.removed.push(filePath);
      } else if (prFile.size !== targetFile.size) {
        fileChanges.modified.push(filePath);
      }
    });

    info(`File changes detected:`);
    info(`  Added: ${fileChanges.added.length}`);
    info(`  Removed: ${fileChanges.removed.length}`);
    info(`  Modified: ${fileChanges.modified.length}`);

    // Log sample of changes for debugging
    if (fileChanges.added.length > 0) {
      const sample = fileChanges.added.slice(0, 3);
      info(
        `  Sample added files: ${sample.join(', ')}${fileChanges.added.length > 3 ? '...' : ''}`,
      );
    }
    if (fileChanges.removed.length > 0) {
      const sample = fileChanges.removed.slice(0, 3);
      info(
        `  Sample removed files: ${sample.join(', ')}${fileChanges.removed.length > 3 ? '...' : ''}`,
      );
    }
    if (fileChanges.modified.length > 0) {
      const sample = fileChanges.modified.slice(0, 3);
      info(
        `  Sample modified files: ${sample.join(', ')}${fileChanges.modified.length > 3 ? '...' : ''}`,
      );
    }

    // No changes found, exit early
    if (targetStats.totalSize === prStats.totalSize) {
      info('No changes detected: Total sizes are identical between branches');
      info('Action completed without posting a comment');
      return;
    }

    info('Size difference detected, generating comment...');

    if (replaceComment === 'true') {
      info('Checking for existing filediff comments to replace...');
      // Replace existing filediff comment
      const comments = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
      });

      let deletedCount = 0;
      for (let comment of comments.data) {
        if (comment.body?.startsWith(commentHash)) {
          await octokit.rest.issues.deleteComment({
            owner,
            repo,
            comment_id: comment.id,
          });
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        info(`Deleted ${deletedCount} existing filediff comment(s)`);
      } else {
        info('No existing filediff comments found');
      }
    }

    const commentBody = getStatComment(
      targetStats,
      prStats,
      fileDetailsOpen === 'true',
    );

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });

    info('Comment posted successfully to PR');
  } catch (error) {
    setFailed(
      error instanceof Error ? error.message : 'An unexpected error occurred',
    );
  }
};

run();
