declare module "gifenc" {
  export type Palette = Array<[number, number, number] | [number, number, number, number]>;

  export type FrameOptions = {
    delay?: number;
    palette?: Palette;
    repeat?: number;
  };

  export type Encoder = {
    bytes: () => Uint8Array;
    finish: () => void;
    writeFrame: (
      index: Uint8Array,
      width: number,
      height: number,
      options?: FrameOptions,
    ) => void;
  };

  export function GIFEncoder(): Encoder;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
  ): Uint8Array;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
  ): Palette;
}
