export interface Collections {}

export type CollectionName = keyof Collections & string;

type Scalar = string | number | boolean | Date;

type Operators<V> = {
  eq?: V | null;
  neq?: V | null;
  gt?: V | null;
  gte?: V | null;
  lt?: V | null;
  lte?: V | null;
  like?: string | null;
  notLike?: string | null;
  anyEq?: V | null;
  anyNeq?: V | null;
  anyGt?: V | null;
  anyGte?: V | null;
  anyLt?: V | null;
  anyLte?: V | null;
  anyLike?: string | null;
  anyNotLike?: string | null;
  insensitive?: boolean;
  length?: Operators<number>;
  each?: Operators<V>;
  empty?: boolean;
};

type FieldWhere<V> = [NonNullable<V>] extends [infer U]
  ? U extends readonly (infer E)[]
    ? E | Operators<Extract<E, Scalar>>
    : U extends string
      ? U | Operators<U> | Record<string, unknown>
      : U extends Scalar
        ? U | Operators<U>
        : Record<string, unknown>
  : never;

export type Where<T> = string extends keyof T
  ? Record<string, unknown>
  : { [K in keyof T]?: FieldWhere<T[K]> | null } & {
      AND?: Where<T>[];
      OR?: Where<T>[];
    };

type Direction = "asc" | "desc";

type OrderEntry<T> = { [K in keyof T & string]?: Direction };

export type OrderBy<T> = OrderEntry<T> | OrderEntry<T>[];

export interface FindManyArgs<T> {
  where?: Where<T>;
  orderBy?: OrderBy<T>;
  page?: number;
  perPage?: number;
  count?: boolean;
}

export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}
