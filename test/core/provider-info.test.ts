import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, PROVIDER_INFO } from '../../src';

describe('PROVIDER_INFO', () => {
    it.each(PROVIDER_IDS)('%s tiene nombre, sitio, documentación y logo', (id) => {
        const info = PROVIDER_INFO[id];
        expect(info.id).toBe(id);
        expect(info.name).not.toBe('');
        for (const url of [info.website, info.docs, info.logo]) {
            expect(new URL(url).protocol).toBe('https:');
        }
    });
});
