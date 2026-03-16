# dotmd-cli task runner

# Run all tests
test:
    npm test

# Publish the latest git tag to npm. Fails if HEAD is not tagged.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    tag=$(git describe --tags --exact-match HEAD 2>/dev/null) || { echo "error: HEAD is not tagged — tag a release first (e.g. git tag v0.6.0)" >&2; exit 1; }
    version=${tag#v}
    pkg_version=$(node -p "require('./package.json').version")
    if [ "$version" != "$pkg_version" ]; then
        echo "error: tag $tag does not match package.json version $pkg_version" >&2
        exit 1
    fi
    echo "Publishing dotmd-cli@$version ..."
    npm publish --access public
