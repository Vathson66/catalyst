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
    * Strict "One-and-Done" enforcement: Balances do not roll over. Unused funds from an active loan are forfeited once used.

### 2. Catalyst Server-Side Logic (Next.js API & Server Actions)
* **Data Parsing:** All API routes must fetch the `portfolio` metafield, parse the JSON, and evaluate only the `active_loan` node.
* **API: `/api/apply-loan` (Triggered on "Proceed to Payment" CTA)**
    * **Action 1 (Reset):** Fetch current Store Credit balance. If > 0, execute API call to reduce to 0.
    * **Action 2 (Validation):** Parse JSON. Ensure `active_loan.status == "Active"` AND `requested_amount <= active_loan.approved_amount`.
    * **Action 3 (Create):** Call BC V3 REST API `POST /v3/customers/{customer_id}/store_credit` for the exact `requested_amount`.
    * **Action 4 (State Lock):** Update the JSON metafield to set `active_loan.status = "Under Processing"`.
* **API: `/api/reset-loan` (Triggered on Cart modification or Checkout abandonment)**
    * **Action:** Zero out Store Credit AND update the JSON metafield to revert `active_loan.status = "Active"`.

### 3. Catalyst Client-Side UI (Checkout Step 1)
* **Component:** `<LoanConsent />`
* **Visibility Logic:** Parse the JSON payload. Render ONLY IF `active_loan` exists AND `active_loan.status` is "Active" or "Under Processing".
* **State Management:** Use LocalStorage or Cookies to remember `selected_loan_amount`. This prevents data loss if the user refreshes the page.
* **Routing & Execution:** 
    * User enters amount -> Clicks "Proceed to Payment".
    * Intercept click -> Show Spinner -> Call `/api/apply-loan` -> Redirect to `checkout-js` subdomain.
* **Return to Cart Hook:** If Next.js detects navigation away from checkout back to the storefront/cart, fire `navigator.sendBeacon('/api/reset-loan')` to wipe the Store Credit in the background.

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
