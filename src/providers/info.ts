import type {ProviderId} from '../create-payment-adapter';

export interface ProviderInfo {
    id: ProviderId;
    /** Nombre comercial. */
    name: string;
    /** Página principal del proveedor. */
    website: string;
    /** Documentación para desarrolladores. */
    docs: string;
    /**
     * Ícono del proveedor para listas y selectores. Se pide al servicio de favicons por dominio en vez de
     * copiar los logos oficiales al repo: las marcas son de cada proveedor.
     */
    logo: string;
}

const favicon = (domain: string): string => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
    transbank: {
        id: 'transbank',
        name: 'Transbank Webpay Plus',
        website: 'https://www.transbank.cl',
        docs: 'https://www.transbankdevelopers.cl',
        logo: favicon('transbank.cl'),
    },
    flow: {
        id: 'flow',
        name: 'Flow',
        website: 'https://www.flow.cl',
        docs: 'https://developers.flow.cl',
        logo: favicon('flow.cl'),
    },
    mercadopago: {
        id: 'mercadopago',
        name: 'Mercado Pago',
        website: 'https://www.mercadopago.cl',
        docs: 'https://www.mercadopago.cl/developers',
        logo: favicon('mercadopago.cl'),
    },
    venti: {
        id: 'venti',
        name: 'Venti',
        website: 'https://ventipay.com',
        docs: 'https://docs.ventipay.com',
        logo: favicon('ventipay.com'),
    },
    getnet: {
        id: 'getnet',
        name: 'Getnet',
        website: 'https://www.getnet.cl',
        docs: 'https://www.getnet.cl',
        logo: favicon('getnet.cl'),
    },
    klap: {
        id: 'klap',
        name: 'Klap',
        website: 'https://www.klap.cl',
        docs: 'https://developers.klap.cl',
        logo: favicon('klap.cl'),
    },
    khipu: {
        id: 'khipu',
        name: 'Khipu',
        website: 'https://khipu.com',
        docs: 'https://docs.khipu.com',
        logo: favicon('khipu.com'),
    },
    fintoc: {
        id: 'fintoc',
        name: 'Fintoc',
        website: 'https://fintoc.com',
        docs: 'https://docs.fintoc.com',
        logo: favicon('fintoc.com'),
    },
};
