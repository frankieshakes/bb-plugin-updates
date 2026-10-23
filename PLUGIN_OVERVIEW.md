See every plugin update in one place, including the ones `bb plugin outdated`
can't see, and apply them in a click.

## What you get

- A count on the **Plugin Updates** nav icon whenever a plugin has an
  update, and a toast when a new version appears (can be turned off).
- A **Plugin Updates** page listing compatible updates (with Update all),
  newer releases outside a plugin's installed range or pin, releases blocked
  by engine ranges, and collapsed Up to date, Ignored, and Pinned lists.
- A `bb plugin-updates` command with the same checks for terminals and agents.

## How it works

bb's own update check covers updates inside each plugin's semver range. For
git-installed plugins this plugin also lists the repository's release tags
with `git ls-remote`, so a `^0.7.0` install hears about `0.9.0`. Moving to such
a release removes and reinstalls the plugin at the new version, keeping the
range or pin style it was installed with; settings are restored, and a failed
install rolls back to the old version. Checks run on load and every 6 hours by
default. Nothing is sent anywhere except git requests to each plugin's own
repository.
