-- Payment routing belongs to off-chain listings, not the Tender task contract.
-- Existing listings keep escrow. Zero windows and no verifier mark immediate APIs.
alter table services add column payment_mode text not null default 'escrow';
alter table services add column x402 jsonb;
alter table services drop constraint services_verifier_check;
alter table services add constraint services_verifier_check check (verifier in ('hirer', 'judge', 'none'));
alter table services add constraint services_payment_check check (
  (payment_mode = 'escrow' and x402 is null and verifier in ('hirer', 'judge')
    and commit_secs > 0 and reveal_secs > 0 and pick_secs > 0)
  or
  (payment_mode = 'x402' and x402 is not null and verifier = 'none'
    and commit_secs = 0 and reveal_secs = 0 and pick_secs = 0)
);
