# Demo Shop Architecture

This service demonstrates an e-commerce API where `src/session.ts` is shared by both `src/auth/` and `src/billing/`.

- `src/auth/login.ts` -> Calls `createSession`
- `src/billing/checkout.ts` -> Calls `validateSession`
- Shared invariant: Sessions expire strictly after TTL; checkout requires valid active session.
