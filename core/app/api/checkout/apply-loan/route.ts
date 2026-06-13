import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { fetchLoanApproval } from '~/lib/checkout/bc-api/customer-metafields';
import { loadCheckoutSession } from '~/lib/checkout/session';

const ApplyLoanBodySchema = z.object({
  checkoutId: z.string().min(1),
  customerId: z.number().int().positive().optional(),
  requestedAmount: z.number().positive().optional(),
  customAmount: z.number().positive().optional(),
  useLoan: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parseResult = ApplyLoanBodySchema.safeParse(await request.json());

    if (!parseResult.success) {
      return NextResponse.json({ error: 'Loan request payload is invalid' }, { status: 400 });
    }

    const { checkoutId, customerId, useLoan } = parseResult.data;

    if (useLoan === false) {
      return NextResponse.json({ appliedAmount: 0, status: 'Active' });
    }

    const requestedAmount = parseResult.data.requestedAmount ?? parseResult.data.customAmount;

    if (!requestedAmount) {
      return NextResponse.json({ error: 'requestedAmount is required' }, { status: 400 });
    }

    const session = await loadCheckoutSession(checkoutId);
    const loanApproval = await fetchLoanApproval(customerId ?? session.customerId);
    const maxApplicableAmount = Math.min(loanApproval.approvedAmount, session.grandTotal);

    if (!loanApproval.approved || loanApproval.status !== 'Active') {
      return NextResponse.json(
        { error: 'No active loan is available for this checkout' },
        { status: 409 },
      );
    }

    if (requestedAmount > maxApplicableAmount) {
      return NextResponse.json(
        { error: 'Requested loan amount exceeds the available approval' },
        { status: 400 },
      );
    }

    return NextResponse.json({
      appliedAmount: requestedAmount,
      residual: Math.max(session.grandTotal - requestedAmount, 0),
      status: 'Under Processing',
      loanReference: loanApproval.loanReference,
      source: loanApproval.source,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to apply loan';

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
