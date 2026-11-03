function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, canonical(child)]),
        );
    return value;
}

export const sameJson = (left: unknown, right: unknown): boolean =>
    JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
