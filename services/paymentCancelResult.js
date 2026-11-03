/**
 * P5: account-service's PaymentIntent cancel answers HTTP 200 with status "refund_required" when the
 * intent had already been captured at Stripe (money moved). That is an intermediate outcome - a refund
 * is still owed - NOT a completed cancellation or refund. Callers must record it as a pending refund and
 * must never treat the payment as released, refunded or financially settled.
 */
function isRefundRequiredResult(result) {
  return Boolean(result && result.status === "refund_required");
}

module.exports = { isRefundRequiredResult };
