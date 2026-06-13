import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { updateLoanStatus } from '~/lib/checkout/bc-api/customer-metafields';
import { clearCustomerStoreCreditBalance } from '~/lib/checkout/bc-api/customer-store-credit';
import { loadCheckoutSession } from '~/lib/checkout/session';

const ResetLoanBodySchema = z.object({
  checkoutId: z.string().min(1).optional(),
  customerId: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const bodyText = await request.text();
    const body = bodyText ? JSON.parse(bodyText) : {};
    const parseResult = ResetLoanBodySchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json({ error: 'Loan reset payload is invalid' }, { status: 400 });
    }

    const { checkoutId } = parseResult.data;
    let customerId = parseResult.data.customerId;

    if (!customerId && checkoutId) {
      const session = await loadCheckoutSession(checkoutId);
      customerId = session.customerId > 0 ? session.customerId : undefined;
    }

    if (customerId) {
      await clearCustomerStoreCreditBalance(customerId);
      await updateLoanStatus(customerId, 'Active');
    }

    return NextResponse.json({ status: 'Active', appliedAmount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to reset loan';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
