export interface Collections {}

export type CollectionName = keyof Collections & string;

type Scalar = string | number | boolean | Date;

declare const relation: unique symbol;
type RelationMarker = { readonly [relation]?: true };
// Plain strings stay assignable; the optional marker lets Where<T> allow relation paths only here.
export type Relation = string & RelationMarker;

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
    : [U] extends [RelationMarker]
      ? U | Operators<string> | Record<string, unknown>
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

type ExpandTree = { [key: string]: true | ExpandTree | undefined };

type IsRelation<V> = [V] extends [readonly (infer E)[]]
  ? [E] extends [RelationMarker]
    ? true
    : false
  : [V] extends [RelationMarker]
    ? true
    : false;

type RelationKeys<T> = {
  [K in keyof T & string]-?: IsRelation<NonNullable<T[K]>> extends true
    ? K
    : never;
}[keyof T & string];

// Relation fields of T and back-relations ("comments_via_post"); nested levels are untyped.
export type Expand<T> = unknown extends T
  ? ExpandTree
  : string extends keyof T
    ? ExpandTree
    : { [K in RelationKeys<T>]?: true | ExpandTree } & {
        [K in `${string}_via_${string}`]?: true | ExpandTree;
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
  expand?: Expand<T>;
}

export interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}
