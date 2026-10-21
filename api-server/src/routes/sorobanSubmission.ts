import type { Response } from 'express';
import type { SubmitCallResult } from '../soroban.js';

export function respondIfNotConfirmed(
  res: Response,
  submission: SubmitCallResult,
): submission is Exclude<SubmitCallResult, { status: 'confirmed' }> {
  if (submission.status === 'prepared') {
    res.status(428).json({
      error: 'Caller authorization required',
      transaction_xdr: submission.transaction_xdr,
      authorization_entries_xdr: submission.authorization_entries_xdr,
    });
    return true;
  }

  if (submission.status === 'pending') {
    res.status(202).json({
      status: 'pending',
      transaction_hash: submission.transaction_hash,
    });
    return true;
  }

  return false;
}
