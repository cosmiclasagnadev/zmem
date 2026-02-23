# Meeting about usages in wallet 

Sat, 21 Feb 26

### Free Plan Pricing Structure

- Usage-based fees for free + $99 plans only
  - 2% transaction fee
  - 0.7% billing management fee
  - $0.10 per reservation (includes email/notifications)
  - $0.10 per individual invoice sent
- Groups and social features remain free
- Events posting free (charge on transactions only)

### Cost Analysis & Thresholds

- 20 students scenario breakdown:
  - Monthly revenue: $3,200 ($160/student)
  - Billing management: $22.40 (0.7%)
  - Reservations: $6 (60 reservations at $0.10)
  - Total monthly cost: ~$99 (excluding Stripe’s 2.9%)
- Upgrade threshold to $299 plan: ~50 students
  - At 50+ students, usage fees exceed growth plan cost
  - Growth plan includes website + Monstro + Go High Level

### Operational Cost Justification

- Monthly infrastructure costs:
  - Expo: $25 + $3 per build (80+ builds/month = $60)
  - Upstash: $40 (scheduling/automations)
  - Vercel: $20
  - Supabase: $30-40
  - Additional services: Sentry, deep links ($499/month)
- Total platform costs: hundreds to thousands monthly
- 10¢ reservation fee = ~5-6% of customer’s operational costs

### Implementation Tasks

- Add wallet charge validation for reservations
  - Deduct $0.10 per reservation from wallet
  - Maintain $10 minimum wallet threshold
  - Show error dialog when insufficient funds
- Add individual invoice charging
  - $0.10 per invoice sent (not subscription-based invoices)
  - Integrate with wallet system

---
