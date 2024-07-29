import typescript from '@rollup/plugin-typescript';

export default [
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/bundle.js',
      format: 'umd',
      name: 'Affine',
      sourcemap: true
    },
    plugins: [
      typescript()
    ]
  },
  {
    input: 'src/affine-service-worker.ts',
    output: {
      file: 'dist/affine-service-worker.js',
      format: 'iife',
      sourcemap: true
    },
    plugins: [
      typescript()
    ]
  }
];
