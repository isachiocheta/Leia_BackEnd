-- Leia+: somente os seis gêneros da referência e o estado de todas as sequências.
-- Origem: banco temporário com migrations + db:seed:all; nenhum bootstrap/demo.
-- Aplicar depois de 001_schema.sql, uma única vez na instalação vazia.
-- Sequências sem dados mantêm is_called=false; generos continua após os IDs importados.
BEGIN;
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (1, 'Aventura', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (2, 'Conto', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (3, 'Fábula', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (4, 'Ficção científica', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (5, 'Poesia', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
INSERT INTO public.generos (id, nome, criado_em, atualizado_em) VALUES (6, 'Romance', '2026-11-03 12:56:24.213654-03', '2026-11-03 12:56:24.213654-03');
SELECT pg_catalog.setval('public.ciclos_leitura_id_seq', 1, false);
SELECT pg_catalog.setval('public.encontros_id_seq', 1, false);
SELECT pg_catalog.setval('public.generos_id_seq', 6, true);
SELECT pg_catalog.setval('public.inscricoes_encontro_id_seq', 1, false);
SELECT pg_catalog.setval('public.livros_id_seq', 1, false);
SELECT pg_catalog.setval('public.participacoes_leitura_id_seq', 1, false);
SELECT pg_catalog.setval('public.usuarios_id_seq', 1, false);
COMMIT;
