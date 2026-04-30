import { NextRequest, NextResponse } from 'next/server';

import { bcManagementBase, bcManagementHeaders } from '~/lib/checkout/bc-api/auth';

interface BcShippingOption {
  id: string;
  description: string;
  cost: number;
  transit_time?: string;
  is_recommended?: boolean;
}

interface BcConsignment {
  id: string;
  available_shipping_options?: BcShippingOption[];
}

interface BcCheckoutResponse {
  data: {
    id: string;
    consignments?: BcConsignment[];
    cart: {
      line_items: {
        physical_items: Array<{ id: string; quantity: number }>;
        digital_items: Array<{ id: string; quantity: number }>;
        custom_items: Array<{ id: string; quantity: number }>;
      };
    };
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      checkoutId: string;
      address: {
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
        address1: string;
        address2?: string;
        city: string;
        stateOrProvinceCode: string;
        postalCode: string;
        countryCode: string;
      };
    };

    const { checkoutId, address } = body;

    if (!checkoutId || !address) {
      return NextResponse.json({ error: 'checkoutId and address are required' }, { status: 400 });
    }

    const base = bcManagementBase();
    const headers = bcManagementHeaders();

    const checkoutRes = await fetch(`${base}/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers,
      cache: 'no-store',
    });

    if (!checkoutRes.ok) {
      const text = await checkoutRes.text();
      return NextResponse.json(
        { error: `BC checkout load failed [${checkoutRes.status}]: ${text}` },
        { status: checkoutRes.status },
      );
    }

    const checkoutData = (await checkoutRes.json()) as BcCheckoutResponse;
    const cart = checkoutData.data.cart;

    const lineItems = [
      ...(cart.line_items?.physical_items ?? []),
      ...(cart.line_items?.digital_items ?? []),
      ...(cart.line_items?.custom_items ?? []),
    ].map((li) => ({ item_id: li.id, quantity: li.quantity }));

    // Delete existing consignments first
    for (const c of checkoutData.data.consignments ?? []) {
      await fetch(
        `${base}/checkouts/${encodeURIComponent(checkoutId)}/consignments/${c.id}`,
        { method: 'DELETE', headers },
      );
    }

    const bcAddress = {
      first_name: address.firstName,
      last_name: address.lastName,
      email: address.email ?? '',
      phone: address.phone ?? '',
      address1: address.address1,
      address2: address.address2 ?? '',
      city: address.city,
      state_or_province_code: address.stateOrProvinceCode,
      postal_code: address.postalCode,
      country_code: address.countryCode,
    };

    const consignmentRes = await fetch(
      `${base}/checkouts/${encodeURIComponent(checkoutId)}/consignments?include=consignments.available_shipping_options`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify([{ address: bcAddress, line_items: lineItems }]),
      },
    );

    if (!consignmentRes.ok) {
      const text = await consignmentRes.text();
      return NextResponse.json(
        { error: `BC consignment creation failed [${consignmentRes.status}]: ${text}` },
        { status: consignmentRes.status },
      );
    }

    const consignmentData = (await consignmentRes.json()) as BcCheckoutResponse;
    const consignment = consignmentData.data.consignments?.[0];

    if (!consignment) {
      return NextResponse.json({ error: 'No consignment returned from BC' }, { status: 502 });
    }

    const options = (consignment.available_shipping_options ?? []).map((o) => ({
      id: o.id,
      description: o.description,
      cost: o.cost,
      transitTime: o.transit_time ?? undefined,
      isRecommended: o.is_recommended ?? false,
    }));

    return NextResponse.json({ consignmentId: consignment.id, options });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
