I'm forking https://github.com/hylyh/bondage.js/tree/2.0 to fix some bugs and add a feature.  Here is a list of changes I've made:
- Updated versions of library dependencies.
- Fix a few bugs related to order-of-operations.  For example: ```!m && !n``` was not evaluating the same as ```(!m) && (!n)```.
- Fixed a bug related to indenting messing up nested option collections.  They weren't being recognized as options if extra indenting occurred, such as for "if" blocks.
- Added the ability to save and restore the position within a node.  This means adding a ```runner.getPosition()```, which gets the current position within the node, and modifying ```runner.run(x)``` to take a new parameter that is the result of a call to "getPosition()".  This allows saving and restoring a runner to the exact line.
