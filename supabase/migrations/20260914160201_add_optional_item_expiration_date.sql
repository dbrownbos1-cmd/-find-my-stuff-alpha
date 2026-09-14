alter table public.items add column if not exists expiration_date date;
comment on column public.items.expiration_date is 'Optional user-entered expiration date from the item label; null means unknown or not applicable.';
