import os


def load(path, mode='r'):
    with open(path, mode) as handle:
        return handle.read()


class Store:
    def __init__(self, root):
        self.root = root

    def path_for(self, name):
        return os.path.join(self.root, name)
