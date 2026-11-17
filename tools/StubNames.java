import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import javax.tools.*;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

class StubNames {
    record Declaration(ClassTree tree, String canonical, String internal, String packageName,
                       Map<String, Bound> bounds) {}
    record Bound(Tree type, Map<String, Bound> scope) {}

    static final Map<String, String> classes = new HashMap<>();
    static final List<Declaration> declarations = new ArrayList<>();

    public static void main(String[] arguments) throws Exception {
        var compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) throw new IllegalStateException("StubNames requires a JDK with javac");
        try (var paths = Files.walk(Path.of(arguments[0]));
             var files = compiler.getStandardFileManager(null, null, java.nio.charset.StandardCharsets.UTF_8)) {
            var sources = paths.filter(path -> path.toString().endsWith(".java")).sorted().toList();
            var diagnostics = new DiagnosticCollector<JavaFileObject>();
            var task = (JavacTask) compiler.getTask(null, files, diagnostics, List.of("-proc:none"), null,
                    files.getJavaFileObjectsFromPaths(sources));
            // Attribution would require the Android build's classpath; only syntax trees are needed.
            for (var unit : task.parse()) {
                var packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
                for (var declaration : unit.getTypeDecls()) {
                    if (declaration instanceof ClassTree type) collect(type, packageName, "", "", Map.of());
                }
            }
            for (var diagnostic : diagnostics.getDiagnostics()) {
                if (diagnostic.getKind() == Diagnostic.Kind.ERROR) throw new IllegalStateException(diagnostic.toString());
            }
        }
        var lines = new ArrayList<String>();
        for (var declaration : declarations) {
            for (var member : declaration.tree().getMembers()) {
                if (!(member instanceof MethodTree method) || method.getParameters().isEmpty()) continue;
                var bounds = bounds(declaration.bounds(), method.getTypeParameters());
                var types = method.getParameters().stream()
                        .map(parameter -> erased(parameter.getType(), declaration.packageName(), bounds, new HashSet<>()))
                        .collect(Collectors.joining(","));
                var names = method.getParameters().stream().map(parameter -> parameter.getName().toString())
                        .collect(Collectors.joining(","));
                lines.add(declaration.internal() + "\t" + method.getName() + "\t" + types + "\t" + names);
            }
        }
        lines.stream().sorted().forEach(System.out::println);
    }

    static Map<String, Bound> bounds(Map<String, Bound> inherited, List<? extends TypeParameterTree> parameters) {
        var scope = new HashMap<>(inherited);
        for (var parameter : parameters) {
            scope.put(parameter.getName().toString(), new Bound(
                    parameter.getBounds().isEmpty() ? null : parameter.getBounds().getFirst(), scope));
        }
        return scope;
    }

    static void collect(ClassTree tree, String packageName, String owner, String internalOwner,
                        Map<String, Bound> inherited) {
        var name = tree.getSimpleName().toString();
        var canonical = (owner.isEmpty() ? packageName : owner) + "." + name;
        if (canonical.startsWith(".")) canonical = canonical.substring(1);
        var internal = internalOwner.isEmpty() ? canonical.replace('.', '/') : internalOwner + "$" + name;
        var scope = bounds(inherited, tree.getTypeParameters());
        classes.put(canonical, internal.replace('/', '.'));
        declarations.add(new Declaration(tree, canonical, internal, packageName, scope));
        for (var member : tree.getMembers()) {
            if (member instanceof ClassTree nested) collect(nested, packageName, canonical, internal, scope);
        }
    }

    static String erased(Tree tree, String packageName, Map<String, Bound> bounds, Set<String> resolving) {
        if (tree instanceof AnnotatedTypeTree annotated) return erased(annotated.getUnderlyingType(), packageName, bounds, resolving);
        if (tree instanceof ArrayTypeTree array) return erased(array.getType(), packageName, bounds, resolving) + "[]";
        if (tree instanceof ParameterizedTypeTree generic) return erased(generic.getType(), packageName, bounds, resolving);
        if (tree instanceof PrimitiveTypeTree primitive) return primitive.toString();
        if (tree instanceof MemberSelectTree member) {
            return canonical(qualified(member));
        }
        var name = tree.toString();
        var bound = bounds.get(name);
        if (bound != null) {
            if (bound.type() == null) return "java.lang.Object";
            if (!resolving.add(name)) throw new IllegalArgumentException("Cyclic type bound: " + name);
            var type = erased(bound.type(), packageName, bound.scope(), resolving);
            resolving.remove(name);
            return type;
        }
        return canonical(name.contains(".") || packageName.isEmpty() ? name : packageName + "." + name);
    }

    static String qualified(Tree tree) {
        if (tree instanceof ParameterizedTypeTree generic) return qualified(generic.getType());
        if (tree instanceof AnnotatedTypeTree annotated) return qualified(annotated.getUnderlyingType());
        if (tree instanceof MemberSelectTree member) return qualified(member.getExpression()) + "." + member.getIdentifier();
        return tree.toString();
    }

    static String canonical(String name) {
        for (int end = name.length(); end > 0; end = name.lastIndexOf('.', end - 1)) {
            var known = classes.get(name.substring(0, end));
            if (known != null) return known + name.substring(end).replace('.', '$');
        }
        return name;
    }
}
