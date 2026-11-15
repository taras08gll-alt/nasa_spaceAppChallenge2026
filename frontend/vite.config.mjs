// LUNA-DOC: Vite frontend build: copy Cesium Workers, ThirdParty, Assets, and Widgets into the public output.
// LUNA-DOC: Do not change base, CESIUM_BASE_URL, or node_modules paths without checking production Nginx/Flask configuration.
// LUNA-DOC: Always run npm run build after source JavaScript changes; old assets/*.js bundles will not update automatically.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, normalizePath } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const require = createRequire(import.meta.url);
const cesiumRoot = dirname(require.resolve('cesium/package.json'));

export default defineConfig({
    base: './',
    define: { CESIUM_BASE_URL: JSON.stringify('./cesium/') },
    plugins: [viteStaticCopy({
        targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map(folder => ({
            src: normalizePath(join(cesiumRoot, 'Build', 'Cesium', folder)),
            dest: 'cesium',
        })),
    })],
});
