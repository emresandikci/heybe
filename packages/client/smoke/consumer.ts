import { createClient, type Collections, type Where } from "@heybe/client";

const heybe = createClient("http://127.0.0.1:8090");
const where: Where<Collections["posts"]> = { status: "published" };
const page = await heybe
  .records("posts")
  .findMany({ where, expand: { author: true } });
const email: string | undefined = page.items[0]?.expand?.author?.email;

export { email };
