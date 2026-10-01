import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    // tsup añade baseUrl (deprecado en TS 6) al compilar los tipos
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    minify: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    // Los mapas apuntan a src/ sin incluir su contenido: los stack traces recuperan archivo y línea sin inflar el paquete
    esbuildOptions(options) {
        options.sourcesContent = false;
    },
});
