# TypeScript Compilation Error

```
src/controllers/product.controller.ts:34:34 - error TS2345: Argument of type 'string' is not
assignable to parameter of type 'number'.

34     const products = await getProductsByCategory(req.query.categoryId);
                                                    ~~~~~~~~~~~~~~~~~~~~

src/services/product.service.ts:12:43 - note: The expected type comes from parameter 'categoryId'
which is declared here on type '(categoryId: number) => Promise<Product[]>'

12 export async function getProductsByCategory(categoryId: number): Promise<Product[]> {
                                               ~~~~~~~~~
```

## Source Code

```typescript
// src/controllers/product.controller.ts
export async function listProducts(req: Request, res: Response) {
  const products = await getProductsByCategory(req.query.categoryId);
  res.json({ data: products });
}

// src/services/product.service.ts
export async function getProductsByCategory(categoryId: number): Promise<Product[]> {
  return prisma.product.findMany({ where: { categoryId } });
}
```
