# TODO

- Installer: accept a PocketBase backup zip under "Restore from a backup". Detect a PocketBase
  `data.db` in the uploaded zip and run the `heybe import` flow on it instead of the restore
  (the data dir is still empty at install time). Today the restore route answers 400
  "The file is not a Heybe backup." for it.
