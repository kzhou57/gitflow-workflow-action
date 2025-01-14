// @ts-check
import semverInc from "semver/functions/inc";
import { Config, octokit } from "./shared.js";
import { createExplainComment } from "./utils.js";

/**
 * @returns {Promise<import("./types.js").Result>}
 */
export async function createReleasePR(isHotfix = false) {
  const isDryRun = Config.isDryRun;

  const releaseBaseBranch = isHotfix ? Config.prodBranch : Config.developBranch;
  const releaseBranchPrefix = isHotfix
    ? Config.hotfixBranchPrefix
    : Config.releaseBranchPrefix;
  const releaseTitle = isHotfix ? "Hotfix" : "Release";

  const developBranchSha = (
    await octokit.rest.repos.getBranch({
      ...Config.repo,
      branch: releaseBaseBranch,
    })
  ).data.commit.sha;

  console.log(
    `create_release: Generating release notes for ${developBranchSha}`,
  );

  // developBranch and mainBranch are almost identical
  // so we can use developBranch for ahead-of-time release note
  const { data: latestRelease } = await octokit.rest.repos
    .getLatestRelease(Config.repo)
    .catch(() => ({ data: null }));

  const latest_release_tag_name = latestRelease?.tag_name;

  /**
   * @type {string}
   */
  let version;
  if (Config.version) {
    version = Config.version;
  } else if (Config.versionIncrement) {
    const increasedVersion = semverInc(
      latest_release_tag_name || "0.0.0",
      Config.versionIncrement,
      { loose: true },
    );
    if (!increasedVersion) {
      throw new Error(
        `create_release: Could not increment version ${latest_release_tag_name} with ${Config.versionIncrement}`,
      );
    }
    version = increasedVersion;
  } else {
    version = developBranchSha;
  }

  const { data: releaseNotes } = await octokit.rest.repos.generateReleaseNotes({
    ...Config.repo,
    tag_name: version,
    target_commitish: releaseBaseBranch,
    previous_tag_name: latest_release_tag_name,
  });

  const releasePrBody = `${releaseNotes.body}
    
## Release summary

${Config.releaseSummary}
  `;

  const releaseBranch = `${releaseBranchPrefix}${version}`;
  let pull_number;

  if (!isDryRun) {
    console.log(`create_release: Creating release branch ${releaseBranch}`);

    // create release branch from latest sha of develop branch
    await octokit.rest.git.createRef({
      ...Config.repo,
      ref: `refs/heads/${releaseBranch}`,
      sha: developBranchSha,
    });

    if (isHotfix) {
      console.log(
        `create_release: Hotfix release: have created release branch ${releaseBranch}, have to manually merge fix into it before create PR.`,
      );
        console.log(`create_release: Merging ${releaseBranch} into ${Config.prodBranch}`);
    }
    else{
      console.log(`create_release: Creating Pull Request`);

      const { data: pullRequest } = await octokit.rest.pulls.create({
        ...Config.repo,
        title: `${releaseTitle} ${releaseNotes.name || version}`,
        body: releasePrBody,
        head: releaseBranch,
        base: Config.prodBranch,
        maintainer_can_modify: false,
      });

      pull_number = pullRequest.number;

      await octokit.rest.issues.addLabels({
        ...Config.repo,
        issue_number: pullRequest.number,
        labels: ["release"],
      });

      await createExplainComment(pullRequest.number);

      console.log(
        `create_release: Pull request has been created at ${pullRequest.html_url}`,
      );
    }
  } else {
    console.log(
      `create_release: Dry run: would have created release branch ${releaseBranch} and PR with body:\n${releasePrBody}`,
    );
  }

  // Parse the PR body for PR numbers
  let mergedPrNumbers = (releaseNotes.body.match(/pull\/\d+/g) || []).map(
    (prNumber) => Number(prNumber.replace("pull/", "")),
  );
  // remove duplicates due to the "New contributors" section
  mergedPrNumbers = Array.from(new Set(mergedPrNumbers)).sort();

  return {
    type: isHotfix ? "hotfix" : "release",
    pull_number: pull_number,
    pull_numbers_in_release: mergedPrNumbers.join(","),
    version,
    release_branch: releaseBranch,
    latest_release_tag_name,
  };
}
