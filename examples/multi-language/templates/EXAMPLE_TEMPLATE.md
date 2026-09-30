# Code example template

Copy this template when adding a new scenario to the documentation. Every
scenario must be shown in **Python, JavaScript, Rust and Go**, using the
tabbed layout below so readers can switch languages without losing their place.

````markdown
### <Scenario title>

<One sentence: what the reader achieves and which endpoint(s) it uses.>

<details open><summary><b>Python</b></summary>

```python
# <snippet — keep in sync with examples/multi-language/python/>
```

</details>
<details><summary><b>JavaScript</b></summary>

```javascript
// <snippet — keep in sync with examples/multi-language/javascript/>
```

</details>
<details><summary><b>Rust</b></summary>

```rust
// <snippet — keep in sync with examples/multi-language/rust/>
```

</details>
<details><summary><b>Go</b></summary>

```go
// <snippet — keep in sync with examples/multi-language/go/>
```

</details>

**Output**

```
<exact expected output — copy from expected_output.txt>
```
````

## Checklist for a new scenario

- [ ] Scenario described in [`SPEC.md`](../SPEC.md) (endpoints, request body, exact output lines).
- [ ] Mock responses added to [`mock_server.py`](../mock_server.py).
- [ ] Expected lines appended to [`expected_output.txt`](../expected_output.txt).
- [ ] Implemented in all four languages, with the same numbered step comments.
- [ ] `./scripts/check_code_examples.sh` passes locally.
- [ ] Any docs snippet taken from the examples is updated in the same PR.
