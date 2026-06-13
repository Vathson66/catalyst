import { fetchLoanApproval } from '~/lib/checkout/bc-api/customer-metafields';
import type { CheckoutSession } from '~/lib/checkout/types';

export type CustomerLoanSession = Pick<CheckoutSession, 'loan' | 'loanEnabled'>;

export async function loadCustomerLoanSession(customerId: number): Promise<CustomerLoanSession> {
  const loanApproval = await fetchLoanApproval(customerId);

  return {
    loan: {
      eligible: loanApproval.approved,
      approvedAmount: loanApproval.approvedAmount,
      selected: false,
      appliedAmount: 0,
      status: loanApproval.status,
      loanReference: loanApproval.loanReference,
    },
    loanEnabled: process.env.LOAN_ENABLED === 'true' || loanApproval.source === 'seed',
  };
}
