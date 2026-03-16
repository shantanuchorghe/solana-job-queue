import os
import re

DIR = r"g:\Coding\projects\solana-job-queue\solana-job-queue"

replacements = {
    "solqueue": "decqueue",
    "sol_queue": "dec_queue",
    "sol-queue": "dec-queue",
    "SolQueue": "DecQueue",
    "SOLQUEUE": "DECQUEUE"
}

ignores = [".git", "node_modules", "target", "dist", ".gemini", "rename.py"]

for root, dirs, files in os.walk(DIR):
    # filter out ignored dirs
    dirs[:] = [d for d in dirs if d not in ignores]
    
    for file in files:
        if file in ignores:
            continue
            
        filepath = os.path.join(root, file)
        
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            continue # Skip binary files
            
        new_content = content
        for k, v in replacements.items():
            new_content = new_content.replace(k, v)
            
        if content != new_content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(new_content)
            print(f"Updated content in {filepath}")

# Rename files and directories
for root, dirs, files in os.walk(DIR, topdown=False):
    for name in files + dirs:
        if any(ignore in root for ignore in ignores) or name in ignores:
            continue
            
        new_name = name
        for k, v in replacements.items():
            new_name = new_name.replace(k, v)
            
        if name != new_name:
            old_path = os.path.join(root, name)
            new_path = os.path.join(root, new_name)
            os.rename(old_path, new_path)
            print(f"Renamed {old_path} to {new_path}")
