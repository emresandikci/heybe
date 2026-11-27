# Files

Add a `file` field to a collection, then upload with a normal create or update.

## Upload

```ts
const post = await heybe.records("posts").create({
  title: "hello",
  images: [new File([bytes], "a.png")],
});
```

The client sends a multipart request when a value is a `File`. Stored names get a random suffix to avoid clashes.

To add to existing files, keep the stored names and add the new files:

```ts
await heybe.records("posts").update(post.id, {
  images: [...post.images, new File([bytes], "b.png")],
});
```

The field has a maximum file size (5 MB when unset), an optional list of allowed mime types, and a maximum number of files.

## URLs

```ts
heybe.files.url(post, post.images[0]);
heybe.files.url(post, post.images[0], { thumb: "100x100", download: true });
```

`files.url` returns `""` when the filename, the record id or both collection fields are missing.

## Protected files

Set `protected` on the field to require a file token. Get one for the signed-in user and add it to the URL:

```ts
const token = await heybe.files.token();
heybe.files.url(post, post.images[0], { token });
```

The token is checked against the collection's `viewRule`.

## Thumbnails

List the allowed sizes on the field (`thumbs`), then request one with `thumb`. Formats:

| Size           | Result                                                 |
| -------------- | ------------------------------------------------------ |
| `WxH`          | Crop to fit, centered                                  |
| `WxHt`         | Crop to fit, from the top                              |
| `WxHb`         | Crop to fit, from the bottom                           |
| `WxHf`         | Fit inside the box, never enlarged                     |
| `0xH` or `Wx0` | Resize to the given height or width, keeping the ratio |

JPEG, GIF and PNG output is supported. These environment variables tune thumbnail generation:

| Variable                      | Meaning                                               | Default               |
| ----------------------------- | ----------------------------------------------------- | --------------------- |
| `HB_THUMBS_MAX_SOURCE_PIXELS` | Largest source image (width x height) that is resized | 104857600 (100 << 20) |
| `HB_THUMBS_MAX_WORKERS`       | Thumbnails generated at the same time                 | CPU count + 2         |
| `HB_THUMBS_MAX_WAIT`          | Seconds a request waits for a free worker             | 60                    |

## Storage

Files are stored under `hb_data/storage`, or in an S3 bucket when you enable S3 in the storage settings. Test the connection with `heybe.settings.testS3("storage")`.
