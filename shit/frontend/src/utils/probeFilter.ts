export const RESERVED_CAMERA_PREFIXES = ['__probe_'];

export const isProbeCamera = (name: string): boolean =>
  RESERVED_CAMERA_PREFIXES.some((p) => name.startsWith(p));

export const filterOutProbes = <T extends { name: string } | string>(
  items: T[]
): T[] =>
  items.filter((item) => {
    const name = typeof item === 'string' ? item : item.name;
    return !isProbeCamera(name);
  });