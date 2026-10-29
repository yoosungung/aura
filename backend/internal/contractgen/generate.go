package contractgen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"strings"
)

func Generate(schemaDir, outFile string) error {
	files, err := filepath.Glob(filepath.Join(schemaDir, "*.schema.json"))
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no schemas in %s", schemaDir)
	}
	var types []goType
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		s, err := parseSchema(raw)
		if err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		types = append(types, collect(typeName(file), s)...)
	}
	var b strings.Builder
	b.WriteString("// Code generated from contracts/*.schema.json; DO NOT EDIT.\n\n")
	b.WriteString("package contracts\n\n")
	for _, typ := range types {
		b.WriteString("type ")
		b.WriteString(typ.Name)
		b.WriteString(" struct {\n")
		for _, f := range typ.Fields {
			tag := f.JSON
			if f.Omitempty {
				tag += ",omitempty"
			}
			fmt.Fprintf(&b, "\t%s %s `json:%q`\n", f.Name, f.Type, tag)
		}
		b.WriteString("}\n\n")
	}
	formatted, err := format.Source([]byte(b.String()))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(outFile), 0o755); err != nil {
		return err
	}
	return os.WriteFile(outFile, formatted, 0o644)
}

type schema struct {
	Type       string
	Required   []string
	Properties []prop
}

type prop struct {
	Name   string
	Schema schema
}

type goType struct {
	Name   string
	Fields []goField
}

type goField struct {
	Name      string
	Type      string
	JSON      string
	Omitempty bool
}

func parseSchema(raw []byte) (schema, error) {
	var head struct {
		Type       string          `json:"type"`
		Required   []string        `json:"required"`
		Properties json.RawMessage `json:"properties"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return schema{}, err
	}
	out := schema{Type: head.Type, Required: head.Required}
	if len(head.Properties) == 0 {
		return out, nil
	}
	dec := json.NewDecoder(bytes.NewReader(head.Properties))
	tok, err := dec.Token()
	if err != nil {
		return schema{}, err
	}
	d, ok := tok.(json.Delim)
	if !ok || d != '{' {
		return schema{}, fmt.Errorf("properties not object")
	}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return schema{}, err
		}
		name, ok := key.(string)
		if !ok {
			return schema{}, fmt.Errorf("property name")
		}
		var nested json.RawMessage
		if err := dec.Decode(&nested); err != nil {
			return schema{}, err
		}
		child, err := parseSchema(nested)
		if err != nil {
			return schema{}, err
		}
		out.Properties = append(out.Properties, prop{Name: name, Schema: child})
	}
	return out, nil
}

func collect(name string, s schema) []goType {
	req := map[string]bool{}
	for _, r := range s.Required {
		req[r] = true
	}
	var nested []goType
	var fields []goField
	for _, p := range s.Properties {
		ft := "any"
		if p.Schema.Type == "object" && len(p.Schema.Properties) > 0 {
			child := name + fieldName(p.Name)
			nested = append(nested, collect(child, p.Schema)...)
			ft = child
		} else {
			ft = goPrimitive(p.Schema.Type)
		}
		fields = append(fields, goField{
			Name:      fieldName(p.Name),
			Type:      ft,
			JSON:      p.Name,
			Omitempty: !req[p.Name],
		})
	}
	return append(nested, goType{Name: name, Fields: fields})
}

func goPrimitive(t string) string {
	switch t {
	case "string":
		return "string"
	case "integer":
		return "int"
	case "boolean":
		return "bool"
	case "number":
		return "float64"
	case "array":
		return "[]any"
	default:
		return "any"
	}
}

func typeName(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), ".schema.json")
	parts := strings.FieldsFunc(base, func(r rune) bool {
		return r == '.' || r == '_' || r == '-'
	})
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(export(p))
	}
	return b.String()
}

func fieldName(jsonName string) string {
	parts := strings.Split(jsonName, "_")
	var b strings.Builder
	for _, p := range parts {
		if p == "id" {
			b.WriteString("ID")
			continue
		}
		b.WriteString(export(p))
	}
	return b.String()
}

func export(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
