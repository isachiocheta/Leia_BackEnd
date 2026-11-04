-- Leia+: apenas histórico real do sequelize-cli e proveniência da referência.
-- sequelize_meta: migrations aplicadas; sequelize_seeds: seeder básico executado;
-- generos_semeados: IDs efetivamente criados por ele, preservando sua reversão.
-- Aplicar depois de 002_reference_data.sql. Nenhum registro de demo/usuário/sessão.
-- As tabelas já foram definidas em 001; não há DDL neste arquivo.
BEGIN;
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 1);
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 2);
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 3);
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 4);
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 5);
INSERT INTO public.generos_semeados (semeador, genero_id) VALUES ('20261030061000-carregar-generos-referencia.js', 6);
INSERT INTO public.sequelize_meta (name) VALUES ('20261030000000-criar-dominio.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030010000-completar-usuarios.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030011000-criar-sessoes.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030020000-ajustar-generos.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030021000-completar-livros.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030030000-completar-ciclos-leitura.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030040000-completar-encontros.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030050000-completar-participacoes-leitura.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030051000-ajustar-inscricoes-encontro.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261030060000-criar-controle-referencias.js');
INSERT INTO public.sequelize_meta (name) VALUES ('20261103000000-criar-controle-demonstracao.js');
INSERT INTO public.sequelize_seeds (name) VALUES ('20261030061000-carregar-generos-referencia.js');
COMMIT;
