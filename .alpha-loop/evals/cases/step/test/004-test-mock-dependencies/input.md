# Task: Write tests with mocked external API dependency

Write Jest tests for `getWeatherSummary` which calls an external weather API. The tests must mock
the HTTP client so no real network requests are made.

## Source Code

```typescript
// src/lib/weather.ts
import { httpClient } from './http-client.js';

interface WeatherResponse {
  temperature: number;
  condition: string;
  city: string;
}

export async function getWeatherSummary(city: string): Promise<string> {
  if (!city) {
    throw new Error('City is required');
  }

  const data = await httpClient.get<WeatherResponse>(`/weather?city=${city}`);
  return `${data.city}: ${data.temperature}°C, ${data.condition}`;
}
```

```typescript
// src/lib/http-client.ts
export const httpClient = {
  async get<T>(url: string): Promise<T> {
    const res = await fetch(`https://api.weather.example.com${url}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as T;
  },
};
```

## Requirements

- Use `jest.mock('./http-client.js')` to mock the module
- Test 1 (happy path): mock returns `{ temperature: 22, condition: 'Sunny', city: 'London' }`,
  assert the summary string is `"London: 22°C, Sunny"`
- Test 2 (API error): mock rejects with `new Error('HTTP 503')`, assert the error propagates
- Test 3 (missing city): no mock needed, assert `getWeatherSummary('')` rejects with "City is required"
- Use `beforeEach` to reset mocks between tests
