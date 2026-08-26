import { describe, it, expect } from 'vitest';
import { vmSizeFromLabels, VM_SIZES } from '../index.js';

describe('vmSizeFromLabels', () => {
  it('returns medium defaults when no size label is present', () => {
    expect(vmSizeFromLabels(['self-hosted', 'linux'])).toEqual(VM_SIZES.medium);
  });

  it('returns medium when no labels at all', () => {
    expect(vmSizeFromLabels([])).toEqual(VM_SIZES.medium);
  });

  it('picks the correct size from a burstgrid:size= label', () => {
    expect(vmSizeFromLabels(['burstgrid:size=large'])).toEqual(VM_SIZES.large);
    expect(vmSizeFromLabels(['burstgrid:size=xlarge'])).toEqual(VM_SIZES.xlarge);
    expect(vmSizeFromLabels(['burstgrid:size=2xlarge'])).toEqual(VM_SIZES['2xlarge']);
  });

  it('is case-insensitive', () => {
    expect(vmSizeFromLabels(['BURSTGRID:SIZE=LARGE'])).toEqual(VM_SIZES.large);
    expect(vmSizeFromLabels(['BurstGrid:Size=Small'])).toEqual(VM_SIZES.small);
  });

  it('falls back to medium for an unrecognised size key', () => {
    expect(vmSizeFromLabels(['burstgrid:size=supercomputer'])).toEqual(VM_SIZES.medium);
  });

  it('size label takes precedence over other labels', () => {
    expect(vmSizeFromLabels(['linux', 'burstgrid:size=8xlarge', 'docker'])).toEqual(VM_SIZES['8xlarge']);
  });

  it('all defined sizes resolve correctly', () => {
    for (const [key, expected] of Object.entries(VM_SIZES)) {
      expect(vmSizeFromLabels([`burstgrid:size=${key}`])).toEqual(expected);
    }
  });

  it('returned vcpus and memoryMiB are positive integers', () => {
    const { vcpus, memoryMiB } = vmSizeFromLabels(['burstgrid:size=large']);
    expect(vcpus).toBeGreaterThan(0);
    expect(memoryMiB).toBeGreaterThan(0);
    expect(Number.isInteger(vcpus)).toBe(true);
    expect(Number.isInteger(memoryMiB)).toBe(true);
  });
});
