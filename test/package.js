const path = require('path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

// Validate the package files
tests.packageFiles(path.join(__dirname, '..'));

describe('npm package', () => {
    // 2.0.0-beta.0 was published by hand with a build/ left over from an older source: it lacked the role
    // indicator.reachable of info._online that the source had. npm runs prepack on every pack and publish,
    // by hand or in CI, so build/ always comes from the source being published.
    it('npm pack and npm publish build build/ from the source first (prepack)', () => {
        const packageJson = require('../package.json');
        expect(packageJson.scripts.prepack).to.equal('npm run build');
    });
});
