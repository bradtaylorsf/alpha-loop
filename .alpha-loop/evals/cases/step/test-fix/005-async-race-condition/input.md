# Test Failure Output (Intermittent)

This test passes approximately 60% of the time and fails 40% of the time with no code changes.

```
FAIL tests/services/notification.service.test.ts (intermittent)

  ● sendWelcomeEmail › marks notification as sent after delivery

    expect(received).toBe(expected)

    Expected: "sent"
    Received: "pending"

      34 |     sendWelcomeEmail(user);
      35 |     const notification = await prisma.notification.findUnique({ where: { userId: user.id } });
    > 36 |     expect(notification.status).toBe('sent');
         |                                 ^

      at Object.<anonymous> (tests/services/notification.service.test.ts:36:33)
```

## Source Code

```typescript
// tests/services/notification.service.test.ts
it('marks notification as sent after delivery', async () => {
  const user = await createTestUser();

  sendWelcomeEmail(user);  // <-- line 34

  const notification = await prisma.notification.findUnique({
    where: { userId: user.id },
  });

  expect(notification.status).toBe('sent');
});

// src/services/notification.service.ts
export async function sendWelcomeEmail(user: User): Promise<void> {
  await emailClient.send({
    to: user.email,
    template: 'welcome',
  });
  await prisma.notification.update({
    where: { userId: user.id },
    data: { status: 'sent' },
  });
}
```
