/// <reference lib="webworker" />
import { applyGeometry, makeBlank, makeImages } from './geometry';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (event) => {
  try {
    const { type, bytes, pages, images } = event.data;
    const result =
      type === 'geometry'
        ? await applyGeometry(new Uint8Array(bytes), pages)
        : type === 'blank'
          ? await makeBlank(pages)
          : await makeImages(images);
    scope.postMessage({ bytes: result }, [result.buffer]);
  } catch (error) {
    scope.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
