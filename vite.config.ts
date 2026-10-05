import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  if (command === 'build' && !env.VITE_ENDPOINT) {
    throw new Error(
      'VITE_ENDPOINT is not set. Set it to your Apps Script /exec URL (see SETUP.md), or VITE_ENDPOINT=mock for a throwaway demo build.',
    );
  }
  return {
    plugins: [preact()],
    build: {
      rollupOptions: {
        output: {
          // Neutral chunk names: nothing in the build hints at what a chunk contains.
          chunkFileNames: 'assets/c-[hash].js',
        },
      },
    },
  };
});
