export type LabelLike = string | { name?: string | null } | null | undefined;

export function labelName(label: LabelLike): string | null {
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object' && typeof label.name === 'string') {
    return label.name;
  }
  return null;
}

export function hasLabel(labels: unknown, expected: string): boolean {
  if (!Array.isArray(labels)) return false;
  const expectedLower = expected.toLowerCase();
  return labels.some((label) => labelName(label as LabelLike)?.toLowerCase() === expectedLower);
}
