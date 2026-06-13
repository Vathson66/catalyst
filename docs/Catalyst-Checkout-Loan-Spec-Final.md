# Technical Specification: Custom Loan Checkout Flow (Final)
## Architecture: BigCommerce Catalyst (Next.js) + Checkout-js

### 1. Data Model: Single JSON Customer Metafield
* **Namespace:** `loan_details`
* **Key:** `portfolio` (A single metafield containing a JSON string)
* **JSON Structure (Optimized for O(1) reads of the active loan):**
  ```json
  {
    "active_loan": {
      "loan_reference": "1223456",
      "approved_amount": 1000.00,
      "status": "Active" 
    },
    "history": [
      {
        "loan_reference": "9876543",
        "approved_amount": 500.00,
        "utilized_amount": 450.00,
        "status": "Used" 
      }
    ]
  }
  ```
* **Business Rules:**
    * Maximum of one `active_loan` permitted at a time.
    * `active_loan` is the only loan checkout is allowed to evaluate.
    * `history` is append-only and contains loans that are no longer current.
    * Do not add a newly approved loan directly to `history`. A new approval belongs in `active_loan` until it is used, cancelled, expired, or superseded.
    * Strict "One-and-Done" enforcement: Balances do not roll over. Unused funds from an active loan are forfeited once used.

### 1.1 Customer Metafield Lifecycle
The lending middleware should treat the metafield as a small state machine. This keeps the Catalyst checkout logic simple and makes middleware updates idempotent.

#### Current Loan Contract
* `active_loan = null` means the customer has no usable approval.
* `active_loan.status = "Active"` means checkout may show and apply the loan.
* `active_loan.status = "Under Processing"` means checkout already applied the loan to an order attempt. Checkout must not reuse it in another order.
* `history[]` is for loans that are finished or no longer current. Checkout must never use loans from `history`.

#### When a New Loan Is Approved
1. Read the current `portfolio` metafield.
2. If `active_loan` is `null`, set the new approval as `active_loan` with status `"Active"`.
3. If `active_loan.status` is `"Active"` and the lending system is replacing it with a newer approval, first append the old `active_loan` to `history` with status `"Superseded"`, then set the new approval as `active_loan` with status `"Active"`.
4. If `active_loan.status` is `"Under Processing"`, do not overwrite it. Wait for the order-created process or rollback process to finish first.
5. If `active_loan.status` is `"Used"`, move it to `history` and set `active_loan` to `null` before adding any new approval.

#### When a Loan Is Used In Checkout
1. Catalyst applies the exact selected amount as BigCommerce customer Store Credit.
2. Catalyst updates `active_loan.status` from `"Active"` to `"Under Processing"`.
3. After the order is confirmed, the lending middleware moves the entire `active_loan` object to `history`, adds `utilized_amount`, sets historical `status` to `"Used"`, and sets top-level `active_loan` to `null`.

#### Recommended Middleware Rule
Use this simple rule for all lending-system updates:

> `active_loan` always contains at most one current approval. `history` only receives loans when they leave `active_loan`.

This means the middleware does not need to search `history` to decide checkout eligibility, and Catalyst never has to decide which historical loan is the newest.

### 2. Catalyst Server-Side Logic (Next.js API & Server Actions)
* **Data Parsing:** All API routes must fetch the `portfolio` metafield, parse the JSON, and evaluate only the `active_loan` node.
* **API: `/api/checkout/apply-loan` (Triggered on "Proceed to Payment" CTA)**
    * **Action 1 (Reset):** Fetch current Store Credit balance. If > 0, execute API call to reduce to 0.
    * **Action 2 (Validation):** Parse JSON. Ensure `active_loan.status == "Active"` AND `requested_amount <= active_loan.approved_amount`.
    * **Action 3 (Create):** Update the customer's BigCommerce Store Credit balance for the exact `requested_amount`.
    * **Action 4 (State Lock):** Update the JSON metafield to set `active_loan.status = "Under Processing"`.
* **API: `/api/checkout/reset-loan` (Triggered on Cart modification or Checkout abandonment before order confirmation)**
    * **Action:** Zero out Store Credit.
    * **Rollback Rule:** Only revert `active_loan.status` from `"Under Processing"` to `"Active"` when the checkout was abandoned before an order was confirmed. Never reactivate a `"Used"` loan.

### 3. Catalyst Client-Side UI (Checkout Step 1)
* **Component:** `<LoanConsent />`
* **Visibility Logic:** Parse the JSON payload. Render ONLY IF `active_loan` exists AND `active_loan.status` is `"Active"`.
* **State Management:** Use LocalStorage or Cookies to remember `selected_loan_amount`. This prevents data loss if the user refreshes the page.
* **Routing & Execution:** 
    * User enters amount -> Clicks "Proceed to Payment".
    * Intercept click -> Show Spinner -> Call `/api/checkout/apply-loan` -> Redirect to `checkout-js` subdomain.
* **Return to Cart Hook:** If Next.js detects navigation away from checkout back to the storefront/cart before order confirmation, fire `navigator.sendBeacon('/api/checkout/reset-loan')` to wipe the Store Credit in the background.

### 4. Checkout-js Customization (Subdomain / Step 2)
* **Auto-Apply Logic:**
    * Hook into checkout initialization via `checkout-sdk`.
    * Automatically apply available Store Credit to the grand total.
* **UI Localization & Overrides:**
    * Store Credit must NEVER be labeled as "Store Credit".
    * Update localization files (`en.json`) in the checkout-js repository.
    * Map all "Store Credit" translation keys to "Loan Amount" or "Loan Adjustment".
    * Hide the manual "Apply Store Credit" toggle/button via CSS or component removal.
* **Balance Payment:** Display standard Credit Card component for any remaining balance.

### 5. Post-Order Flow & "One-and-Done" Enforcement
* **Webhook (`order.created`):** The external loan system listens for successful orders.
* **Metafield Update Sequence:**
    * Read the `portfolio` JSON.
    * Move the `active_loan` object into the `history` array.
    * Add `utilized_amount` to the history record (based on exact spent amount).
    * Set historical `status` to "Used".
    * Set the top-level `active_loan` strictly to `null`.
