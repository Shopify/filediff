import {statSync, cpSync, readFileSync} from 'fs';
import {brotliCompressSync, gzipSync} from 'zlib';

import {getInput, setFailed, info} from '@actions/core';
import * as github from '@actions/github';
import {exec} from '@actions/exec';
import {globby} from 'globby';
import prettyBytes from 'pretty-bytes';

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

const getFileStats = async (file: string, branchStats: BranchStats) => {
  const stats = statSync(file);
  const fileContents = readFileSync(file);

  const gzipFile = gzipSync(fileContents);
  const gzipSize = Buffer.byteLength(gzipFile);
  const brotliFile = brotliCompressSync(fileContents);
  const brotliSize = Buffer.byteLength(brotliFile);

  // Remove the GitHub file path from the repo file path
  const filePath = file.split('/').slice(7).join('/');

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
): Promise<BranchStats> => {
  info(`[${branch}] copy repo and git checkout `);
  const tempDir = '.filediff';
  const cwd = `../${tempDir}/${branch}`;
  cpSync('.', cwd, {recursive: true});
  await exec('git', ['fetch', 'origin', branch], {cwd});
  await exec('git', ['checkout', branch], {cwd});

  if (script) {
    info(`[${branch}] Running ${script}`);
    const commands = script.split('&&').map((cmd) => cmd.trim());
    for (const cmd of commands) {
      const [cmdName, ...cmdArgs] = cmd.split(' ');
      await exec(cmdName, cmdArgs, {cwd});
    }
  }

  const files = await globby(dirGlob, {cwd, absolute: true});

  info(`[${branch}] Getting file stats for ${files.length} files`);
  const branchStats: BranchStats = {
    totalSize: 0,
    totalBrotli: 0,
    totalGzip: 0,
    files: {},
  };

  await Promise.all(files.map((file) => getFileStats(file, branchStats)));

  info(`[${branch}] Completed file stats`);

  return branchStats;
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

  const getDiff = (a, b) => prettyBytes(a - b, {signed: true});
  const totalDiff = {
    size: getDiff(prStats.totalSize, targetStats.totalSize),
    gzip: getDiff(prStats.totalGzip, targetStats.totalGzip),
    brotli: getDiff(prStats.totalBrotli, targetStats.totalBrotli),
  };

  let fileColumns = [];
  Object.entries(prStats.files).forEach(([filePath, {size, brotli, gzip}]) => {
    const targetFile = targetStats.files[filePath];

    if (targetFile === undefined) {
      // File in PR is not in target branch (added)
      fileTotals.added = fileTotals.added + 1;
      fileColumns.push(
        `| <sub>${filePath}</sub> | <sub>${prettyBytes(size)} \`${prettyBytes(size, {signed: true})}\`</sub> | <sub>${prettyBytes(gzip)} \`${prettyBytes(gzip, {signed: true})}\`</sub> | <sub>${prettyBytes(brotli)} \`${prettyBytes(brotli, {signed: true})}\`</sub> |`,
      );
    } else if (size !== targetFile.size) {
      // File in PR is in target branch
      fileTotals.changed = fileTotals.changed + 1;
      fileColumns.push(
        `| <sub>${filePath}</sub> | <sub>${prettyBytes(size)} \`${getDiff(size, targetFile.size)}\`</sub> | <sub>${prettyBytes(gzip)} \`${getDiff(gzip, targetFile.gzip)}\`</sub> | <sub>${prettyBytes(brotli)} \`${getDiff(brotli, targetFile.brotli)}\`</sub> |`,
      );
    }
  });

  Object.entries(targetStats.files).forEach(
    ([filePath, {size, brotli, gzip}]) => {
      const prFile = prStats.files[filePath];
      if (prFile === undefined) {
        fileTotals.removed = fileTotals.removed + 1;
        fileColumns.push(
          `| <sub>~${filePath}~</sub> | <sub>0 B \`${prettyBytes(-1 * size, {signed: true})}\`</sub> | <sub>0 B \`${prettyBytes(-1 * gzip, {signed: true})}\`</sub> | <sub>0 B \`${prettyBytes(-1 * brotli, {signed: true})}\`</sub> |`,
        );
      }
    },
  );

  const pluralize = (count, single, plural) => (count === 1 ? single : plural);

  const fChangedText = pluralize(
    fileTotals.changed,
    'file changed',
    'files changed',
  );
  const fAddedText = pluralize(fileTotals.added, 'file added', 'files added');
  const fRemovedText = pluralize(
    fileTotals.removed,
    'file removed',
    'files removed',
  );

  return `${commentHash}\n<sub>**[[filediff]](https://github.com/shopify/filediff)** The total bytes ${totalDiff.size.startsWith('+') ? 'added' : 'removed'} are:</sub>
  | uncompressed | gzip | brotli |
  |:--- |:--- |:--- |
  | <sub>${prettyBytes(prStats.totalSize)} \`${totalDiff.size}\`</sub> | <sub>${prettyBytes(prStats.totalGzip)} \`${totalDiff.gzip}\`</sub> | <sub>${prettyBytes(prStats.totalBrotli)} \`${totalDiff.brotli}\`</sub> |


  <details${fileDetailsOpen ? ' open' : ''}>
    <summary><sub>${fileTotals.changed !== 0 ? `${fileTotals.changed} ${fChangedText}` : ''}${fileTotals.added !== 0 ? `, ${fileTotals.added} ${fAddedText}` : ''}${fileTotals.removed !== 0 ? `, ${fileTotals.removed} ${fRemovedText}` : ''}</sub></summary>

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

    // TODO: Check if a comment already exists and remove it

    const [targetStats, prStats] = await Promise.all([
      getBranchStats(targetBranch, dirGlob, script),
      getBranchStats(prBranch, dirGlob, script),
    ]);

    // No changes found, exit early
    if (targetStats.totalSize === prStats.totalSize) return;

    const commentBody = getStatComment(
      targetStats,
      prStats,
      fileDetailsOpen === 'true',
    );

    // Remove existing filediff comment
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    for (let comment of comments.data) {
      if (comment.body.startsWith('<!-- @alex-page was here -->')) {
        await octokit.rest.issues.deleteComment({
          owner,
          repo,
          comment_id: comment.id,
        });
      }
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody,
    });
  } catch (error) {
    setFailed(error.message);
  }
};

run();
