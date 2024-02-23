<p align="center">
  <img src="https://github.com/Shopify/filediff/blob/main/example.png" alt="A screenshot of the filediff comment" width="688px">
</p>

# filediff

> Create a filediff comment to compare file size changes

## Usage

Create a `.github/workflows/filediff.yml` file.

```yml
name: filediff
on:
  pull_request:

jobs:
  filediff:
    name: filediff
    runs-on: ubuntu-latest
    steps:
      - name: Checkout default branch
        uses: actions/checkout@v4

      - name: Create filediff comment
        uses: Shopify/filediff@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          pre_diff_script: npm run build
          target_branch: main
          dir_glob: packages/**/dist
```

## Environment Variables

**`GITHUB_TOKEN`**

The `GITHUB_TOKEN` is needed for changesets to look up the current changeset when creating a snapshot. You can use the automatically created [`${{ secrets.GITHUB_TOKEN }}` to authenticate in the workflow job](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#about-the-github_token-secret).

## Action workflow options

**`target_branch` (required)**

The branch to compare the directory glob against.

**`dir_glob` (required)**

The files to compare across branches.

**`pre_diff_script` (optional)**

The script to run before generating the filediff comment.

**`file_details_open` (optional, default: false)**

Open the file details when the comment is created

## Changelog

**`v0.0.1`**

- Initial version