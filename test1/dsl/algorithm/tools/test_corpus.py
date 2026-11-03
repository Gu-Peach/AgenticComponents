"""Corpus composition and binding checks; does not establish dynamic truth."""
import os
from pathlib import Path
import unittest
from validate_corpus import read,bind_case,load_parser,CorpusError
from pilot_frontend import load_case,InputError

ALGORITHM=Path(__file__).resolve().parents[1]
ROOT=ALGORITHM/'datasets/ac-path-v1'
DSL=Path(os.environ.get('AC_PILOT_DSL_ROOT',str(ALGORITHM.parent)))


class CorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest=read(ROOT/'manifest.json');cls.parser=load_parser(DSL)

    def test_exact_counts_and_union(self):
        subsets=self.manifest['subsets'];ds=set(subsets['D-S']);dv=set(subsets['D-V'])
        self.assertEqual((len(ds),len(dv),len(ds&dv),len(ds|dv)),(288,360,72,576))
        self.assertEqual(len(self.manifest['cases']),576)

    def test_mutants_share_frozen_task(self):
        for cid in self.manifest['cases']:
            folder=ROOT/'cases'/cid;c=read(folder/'case.json')
            if c['parent_id']:
                parent=ROOT/'cases'/c['parent_id'];p=read(parent/'case.json')
                self.assertEqual((folder/c['inputs']['task']).resolve(),(parent/p['inputs']['task']).resolve())

    def test_splits_do_not_leak_parents(self):
        groups=[read(ROOT/'splits'/f'{name}.json') for name in ('development','validation','test')]
        sets=[set(g['case_ids']) for g in groups]
        self.assertEqual([len(g['parent_ids']) for g in groups],[24,18,30])
        self.assertEqual(set.union(*sets),set(self.manifest['cases']))
        for i,s in enumerate(sets):
            for t in sets[i+1:]:self.assertFalse(s&t)
            for cid in s:
                parent=read(ROOT/'cases'/cid/'case.json')['parent_id']
                if parent:self.assertIn(parent,s)

    def test_static_mutation_categories(self):
        for suffix,code in [('DS01','INVALID_SYNTAX'),('DS02','INVALID_TYPE'),('DS03','UNKNOWN_CAPABILITY')]:
            with self.assertRaises(CorpusError) as err:bind_case(ROOT,'S07-P01-'+suffix,self.parser)
            self.assertEqual(err.exception.code,code)

    def test_parallel_loop_and_processing_bind(self):
        for cid in ['S01-P05','S03-P02','S07-P08','S11-P02','S12-P03']:
            result=bind_case(ROOT,cid,self.parser)
            self.assertGreater(result['node_count'],1)

    def test_generic_case_not_claimed_supported_by_pilot(self):
        with self.assertRaises(InputError) as err:load_case(ROOT,'S04-P02',DSL)
        self.assertEqual(err.exception.code,'UNSUPPORTED_MODEL')

    def test_truth_is_not_inferred_from_mutation(self):
        entries=read(ROOT/'oracle/truth-catalog.json')['records']
        self.assertEqual(len(entries),576)
        self.assertTrue(all(e['independent_path_truth']=='pending' for e in entries))
        e=read(ROOT/'oracle/S07-P01-DV03/expectation.json')
        self.assertEqual(e['path_truth_status'],'unresolved')

    def test_equivalence_pairs_are_not_marked_proved(self):
        for ident in self.manifest['subsets']['D-E']:
            pair=read(ROOT/'equivalents'/ident/'pair.json')
            self.assertFalse(pair['equivalence_proven'])
            self.assertEqual(pair['plc_compile_status'],'passed_open_industry_check_st')
            mapping=read(ROOT/'equivalents'/ident/'model-mapping.json')
            scopes={s['scope'] for s in mapping['steps'] if s['kind']=='control_enter'}
            for step in mapping['steps']:
                if step.get('behavior') in ('transport_to_exit','circulate_once'):
                    self.assertIn(step['scope'],scopes)
                    self.assertNotEqual(step['scope'],'none')

    def test_all_change_inputs_bind(self):
        self.assertEqual(len(self.manifest['subsets']['D-R']),36)
        for ident in self.manifest['subsets']['D-R']:
            folder=ROOT/'changes'/ident;change=read(folder/'change.json')
            result=bind_case(ROOT,change['parent_id'],self.parser,{k:folder/v for k,v in change['overrides'].items()})
            self.assertGreater(result['node_count'],1)

    def test_diagnostic_traces_are_real_records(self):
        entries=read(ROOT/'subsets/D-X.json')['records'];self.assertEqual(len(entries),7)
        for e in entries:
            trace=read(ROOT/e['trace_ref']);self.assertTrue(trace['steps'])
            self.assertEqual(e['independent_truth_status'],'pending')


if __name__=='__main__':unittest.main()
