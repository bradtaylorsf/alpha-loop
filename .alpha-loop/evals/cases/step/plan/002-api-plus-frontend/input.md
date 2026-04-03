# Issue: Add user profile page

## Summary

Users need a way to view and edit their profile information. Create a profile page accessible
from the navigation bar that shows and allows editing of the user's bio, website, and location.

## Requirements

- New page at `/profile` route
- Display current profile data
- Editable form with bio (textarea), website (URL), and location (text) fields
- Save changes via API
- Show success/error feedback to the user

## Context

- Stack: Next.js (App Router), TypeScript, TailwindCSS
- Backend: Express.js API at `/api`
- Database: PostgreSQL via Prisma
- State: TanStack Query for server state

## Acceptance Criteria

- [ ] GET /api/profile returns current user's profile
- [ ] PUT /api/profile updates the profile
- [ ] Input validation on both client and server
- [ ] Profile page renders correctly
- [ ] Form submission works end-to-end
