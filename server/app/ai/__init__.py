"""AI helpers. Safety rule 2: nothing in this package may create, edit or send CNC programs.

The only output allowed from here is SUGGESTED values ("ai" fields) for a feature table, which an
engineer must confirm. tests/test_feature_tables.py checks this package never imports the program
store, the G-code tools or run control.
"""
