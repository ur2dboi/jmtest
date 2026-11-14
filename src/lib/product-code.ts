/** Product-code type is encoded in the issued code and does not follow rank changes. */
export function productCodeKind(code: string | null | undefined): 'PCC' | 'UNI' | 'legacy' {
  if (/^PCC-/i.test(code || '')) return 'PCC';
  if (/^UNI-/i.test(code || '')) return 'UNI';
  return 'legacy';
}

export function productCodeLabel(code: string | null | undefined): string {
  const kind = productCodeKind(code);
  return kind === 'PCC' ? 'Product Commission (PCC)' : kind === 'UNI' ? 'Unilevel (UNI)' : 'Legacy / unspecified';
}
