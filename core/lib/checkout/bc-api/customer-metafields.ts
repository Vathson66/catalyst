import { bcManagementBase, bcManagementHeaders } from './auth';

type LoanStatus = 'Active' | 'Under Processing' | 'Used' | string;

interface LoanPortfolio {
  active_loan?: {
    loan_reference?: string;
    approved_amount?: number | string;
    status?: LoanStatus;
  } | null;
  history?: unknown[];
}

export interface LoanApproval {
  approved: boolean;
  approvedAmount: number;
  status: LoanStatus | null;
  loanReference?: string;
  source: 'metafield' | 'seed' | 'none';
}

const EMPTY_LOAN_APPROVAL: LoanApproval = {
  approved: false,
  approvedAmount: 0,
  status: null,
  source: 'none',
};

const SEEDED_LOAN_PORTFOLIOS: Record<string, LoanPortfolio> = {
  default: {
    active_loan: {
      loan_reference: 'TEST-LOAN-1223456',
      approved_amount: 1000,
      status: 'Active',
    },
    history: [
      {
        loan_reference: 'TEST-LOAN-9876543',
        approved_amount: 500,
        utilized_amount: 450,
        status: 'Used',
      },
    ],
  },
};

function hasManagementApiConfig(): boolean {
  return Boolean(process.env.BIGCOMMERCE_STORE_HASH && process.env.BC_MANAGEMENT_TOKEN);
}

function seededLoanDataEnabled(): boolean {
  return process.env.LOAN_TEST_DATA !== 'false';
}

function parseLoanApprovalFromPortfolio(
  portfolio: LoanPortfolio | null | undefined,
  source: LoanApproval['source'],
): LoanApproval {
  const activeLoan = portfolio?.active_loan;

  if (!activeLoan) {
    return source === 'seed' ? { ...EMPTY_LOAN_APPROVAL, source: 'seed' } : EMPTY_LOAN_APPROVAL;
  }

  const status = activeLoan.status ?? null;
  const amount = Number(activeLoan.approved_amount);
  const visible = status === 'Active' || status === 'Under Processing';

  if (!visible || !Number.isFinite(amount) || amount <= 0) {
    return {
      approved: false,
      approvedAmount: 0,
      status,
      loanReference: activeLoan.loan_reference,
      source,
    };
  }

  return {
    approved: true,
    approvedAmount: amount,
    status,
    loanReference: activeLoan.loan_reference,
    source,
  };
}

function getSeededLoanApproval(customerId: number): LoanApproval {
  const portfolio = SEEDED_LOAN_PORTFOLIOS[String(customerId)] ?? SEEDED_LOAN_PORTFOLIOS.default;

  return parseLoanApprovalFromPortfolio(portfolio, 'seed');
}

/**
 * Reads the merchant loan portfolio from the customer's metafields.
 * Namespace: `loan_details`, Key: `portfolio`
 */
export async function fetchLoanApproval(customerId: number): Promise<LoanApproval> {
  if (seededLoanDataEnabled()) {
    return getSeededLoanApproval(customerId);
  }

  if (!customerId || customerId <= 0 || !hasManagementApiConfig()) {
    return EMPTY_LOAN_APPROVAL;
  }

  const url =
    `${bcManagementBase()}/customers/${encodeURIComponent(String(customerId))}/metafields` +
    `?namespace=loan_details&key=portfolio`;

  const res = await fetch(url, {
    headers: bcManagementHeaders(),
    cache: 'no-store',
  });

  if (!res.ok) {
    return EMPTY_LOAN_APPROVAL;
  }

  const body = (await res.json()) as { data: Array<{ value: string }> };

  if (!body.data?.length) {
    return EMPTY_LOAN_APPROVAL;
  }

  try {
    const portfolio = JSON.parse(body.data[0]!.value) as LoanPortfolio;

    return parseLoanApprovalFromPortfolio(portfolio, 'metafield');
  } catch {
    return EMPTY_LOAN_APPROVAL;
  }
}
