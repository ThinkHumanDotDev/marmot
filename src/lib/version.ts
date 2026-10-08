/**
 * The running Marmot version, inlined from package.json at build time (by Next for the web app and
 * by esbuild for the worker, realtime and CLI bundles). Do not read `process.env.npm_package_version`:
 * it is only set when Node is started through a package-manager script, not in the Docker image (#238).
 */
import pkg from '../../package.json' with { type: 'json' }

export const MARMOT_VERSION: string = pkg.version
