import { describe, it, expect } from 'vitest';
import { vmSizeFromLabels, vmFamilyFromLabels, VM_SIZES } from '../index.js';

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

describe('vmFamilyFromLabels', () => {
  it('defaults to general when no family label is present', () => {
    expect(vmFamilyFromLabels(['burstgrid:size=large'])).toBe('general');
  });

  it('is case-insensitive and recognises compute/memory', () => {
    expect(vmFamilyFromLabels(['BURSTGRID:FAMILY=COMPUTE'])).toBe('compute');
    expect(vmFamilyFromLabels(['burstgrid:family=memory'])).toBe('memory');
  });

  it('falls back to general for an unrecognised family value', () => {
    expect(vmFamilyFromLabels(['burstgrid:family=bogus'])).toBe('general');
  });
});

describe('vmSizeFromLabels — family axis (shape matrix)', () => {
  it('general family (default) leaves vcpus/memoryMiB unchanged', () => {
    expect(vmSizeFromLabels(['burstgrid:size=large', 'burstgrid:family=general'])).toEqual(VM_SIZES.large);
    expect(vmSizeFromLabels(['burstgrid:size=large'])).toEqual(VM_SIZES.large);
  });

  it('compute family halves memory at the same vcpu count', () => {
    const result = vmSizeFromLabels(['burstgrid:size=large', 'burstgrid:family=compute']);
    expect(result.vcpus).toBe(VM_SIZES.large.vcpus);
    expect(result.memoryMiB).toBe(VM_SIZES.large.memoryMiB / 2);
  });

  it('memory family doubles memory at the same vcpu count', () => {
    const result = vmSizeFromLabels(['burstgrid:size=medium', 'burstgrid:family=memory']);
    expect(result.vcpus).toBe(VM_SIZES.medium.vcpus);
    expect(result.memoryMiB).toBe(VM_SIZES.medium.memoryMiB * 2);
  });

  it('size and family axes combine independently', () => {
    const compute = vmSizeFromLabels(['burstgrid:size=xlarge', 'burstgrid:family=compute']);
    const memory = vmSizeFromLabels(['burstgrid:size=xlarge', 'burstgrid:family=memory']);
    expect(compute.vcpus).toBe(memory.vcpus);
    expect(memory.memoryMiB).toBeGreaterThan(compute.memoryMiB);
  });
});
