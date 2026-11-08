export interface Collections {}

export type CollectionName = keyof Collections & string;

type Scalar = string | number | boolean | Date;

declare const relation: unique symbol;
type RelationMarker = { readonly [relation]?: string };
type IsMarked<V> = typeof relation extends keyof V ? true : false;
// Plain strings stay assignable; the optional marker lets Where<T> allow relation paths only here.
export type Relation<C extends string = string> = string & {
  readonly [relation]?: C;
};

type Operators<V> = {
  eq?: V | null;
  neq?: V | null;
  gt?: V | null;
  gte?: V | null;
  lt?: V | null;
  lte?: V | null;
  like?: string | null;
  notLike?: string | null;
  /** On a multi-value field PocketBase's `tags?="x"` matches nothing; use `each: { anyEq: "x" }` (`tags:each?="x"`) instead. */
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
    : IsMarked<U> extends true
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
  ? IsMarked<E> extends true
    ? true
    : false
  : IsMarked<V> extends true
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

type Loose = Record<string, unknown>;

type RelationTarget<V> =
  NonNullable<V> extends readonly (infer E)[] ? E : NonNullable<V>;

type Resolved<V, Sub> =
  RelationTarget<V> extends Relation<infer C>
    ? C extends keyof Collections
      ? WithExpand<Collections[C], Sub extends object ? Sub : undefined>
      : Loose
    : Loose;

type ExpandEntry<T, K, Sub> = K extends keyof T
  ? NonNullable<T[K]> extends readonly unknown[]
    ? Resolved<T[K], Sub>[]
    : Resolved<T[K], Sub>
  : Loose | Loose[];

// Inferred generics skip excess property checks, so unknown expand keys are mapped to `never`.
export type NoExtraExpand<T, E> = {
  [K in Exclude<keyof NonNullable<E>, keyof Expand<T>>]: never;
};

export type ExpandOf<A> = "expand" extends keyof A
  ? A["expand" & keyof A]
  : undefined;

// T plus `expand` typed from E; every entry is optional because PB omits relations the caller cannot view.
export type WithExpand<T, E> = [NonNullable<E>] extends [never]
  ? T
  : T & {
      expand?: {
        [K in keyof NonNullable<E> & string]?: ExpandEntry<
          T,
          K,
          NonNullable<E>[K]
        >;
      };
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
