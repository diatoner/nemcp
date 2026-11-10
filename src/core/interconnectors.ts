export interface InterconnectorInfo { from_region: string | null; to_region: string | null; name: string | null }

/** Positive MW = from_region → to_region (AEMO convention). Add new IDs as they appear. */
const KNOWN: Record<string, InterconnectorInfo> = {
  'NSW1-SA1':  { from_region: 'NSW1', to_region: 'SA1',  name: 'Project EnergyConnect' },
  'NSW1-QLD1': { from_region: 'NSW1', to_region: 'QLD1', name: 'QNI' },
  'N-Q-MNSP1': { from_region: 'NSW1', to_region: 'QLD1', name: 'Terranora (Directlink)' },
  'VIC1-NSW1': { from_region: 'VIC1', to_region: 'NSW1', name: 'VNI' },
  'V-SA':      { from_region: 'VIC1', to_region: 'SA1',  name: 'Heywood' },
  'V-S-MNSP1': { from_region: 'VIC1', to_region: 'SA1',  name: 'Murraylink' },
  'T-V-MNSP1': { from_region: 'TAS1', to_region: 'VIC1', name: 'Basslink' },
};

export function describeInterconnector(id: string): InterconnectorInfo {
  return KNOWN[id] ?? { from_region: null, to_region: null, name: null };
}
